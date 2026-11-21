import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Group } from './group.entity';
import { Repository } from 'typeorm';
import { CreateGroupDto } from './dto/create.group.dto';

@Injectable()
export class GroupService {
  constructor(
    @InjectRepository(Group)
    private groupRepository: Repository<Group>,
  ) {}

  async findById(id: number): Promise<Group> {
    const group = this.groupRepository.findOneBy({ id });

    if (!group) {
      throw new NotFoundException(`Group with id ${id} does not exist!`);
    }

    return group;
  }
  async fetchAll(): Promise<Group[]> {
    return this.groupRepository.find();
  }

  async create(data: CreateGroupDto): Promise<Group> {
    if (await this.groupRepository.findOneBy({ name: data.name })) {
      throw new BadRequestException('Group with this name already exists');
    }

    const newGroup = new Group();
    newGroup.name = data.name;

    return this.groupRepository.save(newGroup);
  }

  async update(id: number, data: CreateGroupDto): Promise<void> {
    const result = await this.groupRepository.update(id, data);

    if (result.affected === 0) {
      throw new NotFoundException();
    }

    return;
  }

  async delete(id: number): Promise<void> {
    const result = await this.groupRepository.delete(id);

    if (result.affected === 0) {
      throw new NotFoundException();
    }

    return;
  }
}
